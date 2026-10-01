[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / POWER\_QUEUE\_INITIAL\_CAPACITY

# Variable: POWER\_QUEUE\_INITIAL\_CAPACITY

> `const` **POWER\_QUEUE\_INITIAL\_CAPACITY**: `16` = `16`

Default preallocation for a `PowerQueue`, and the value every helper that
builds an internal queue passes explicitly.

`PowerQueue` uses a power-of-two bitmask index, so its backing buffer grows by
doubling. Preallocating 16 costs 16 slots and saves four grow-and-copy cycles
for the small queues that dominate: a batch's pending list, a permit gate's
waiters, a sliding window's timestamps, a bulkhead's drain waiters. Those four
sites all passed a bare `16` with no name, which made it impossible to change
the preallocation, impossible to find the sites, and impossible to tell a
deliberate choice from a copy-paste of whatever the default happened to be.

Not to be confused with `DEFAULT_QUEUE_CAPACITY`, which is the backlog a
backpressure helper admits before it starts shedding, not a buffer size.
