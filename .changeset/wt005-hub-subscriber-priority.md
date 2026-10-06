---
'performance-helpers': minor
---

Implement `priority` on `PowerRealtimeHub` subscriptions (WT-005).

A per-subscriber `priority` number (default `0`) controls drain order: on
every flush, subscribers with queued work are visited highest priority first,
ties broken by insertion order. Both flush paths go through one extracted
`_queuedSubscribers()` rather than each sorting its own copy, because
`flush()` walks the same set through `_flushAll` and a priority that only
applied to the microtask path would leave the two paths disagreeing about who
gets served first.

A new static `PowerRealtimeHub._validatePriority(value)` rejects non-finite
input. The case that matters is `NaN`: it coerces silently and compares
unequal to everything, so `Array.sort` lands the subscriber in an arbitrary
position without throwing — a wrong-order delivery with no error, months after
the subscribe that accepted it. The check is extracted from `subscribe()`
because that method was already at the cyclomatic-complexity ceiling.

`stats().list` reflects `priority` back rather than re-deriving it: it is a
value the caller supplied, so reporting it is honest and recomputing it would
be inventing one.

7 tests in `test/powerRealtimeHub.priority.test.js`, mutation-checked. Two
mutants were caught and each caught for a different reason:

- removing the sort from `_drain()` (2 failures);
- bypassing `_queuedSubscribers()` in `_flushAll` (2 failures).

The second is the one that justifies the extraction: a sort in `_drain()` alone
passes every test, because the caller-driven path was never exercising it.

No breaking behaviour change; the default is `0` and equal-priority
subscribers keep insertion order, which is what every existing caller
relies on.
