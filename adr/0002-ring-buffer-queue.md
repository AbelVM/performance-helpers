# 0002. `PowerQueue` is a hand-rolled ring buffer, not an array

**Status:** Accepted
**Affects:** `PowerQueue`, and therefore `PowerBatch` and `PowerPool`'s task queue

## Context

Every language with a decent runtime ships a queue. The obvious
implementation is `Array.prototype.shift()`, and it is the wrong choice for a
structure that is drained on a hot path — which is exactly what this one is.

`shift()` on a JavaScript array is O(n) in the general case: the remaining
elements are moved down to close the gap. V8 mitigates this for small arrays by
tracking a start offset, and that mitigation is what makes the cost look like
O(1) in a casual benchmark. It stops being O(1) at some size, and the
threshold is an implementation detail of one engine that can change between
releases.

`PowerQueue` sits under `PowerPool`'s task queue, so its `shift()` runs once per
dispatch. It is not in a drain loop, and it is not the bottleneck — but a
structure whose cost grows with its size is the wrong shape for a component that
other components sit on, because every caller inherits the risk.

## Decision

A fixed-capacity ring buffer, sized to a power of two, with a bitmask instead of
a modulo:

```js
this._capacity = 1;
while (this._capacity < cap) this._capacity <<= 1; // round up to a power of two
this._mask = this._capacity - 1;
this._tail = (this._tail + 1) & this._mask; // not % this._capacity
```

The power-of-two sizing is not incidental: it is what makes the mask correct. A
modulo by a non-constant is measurably slower than an `&`, and this is a hot
path, so the constraint is pushed up into the constructor where it is paid
once. A small non-power-of-two request is rounded _up_ rather than rejected —
`1` and `2` are legitimate hints, and refusing them would be pedantry.

Growth doubles the buffer and copies in order, so it is amortised O(1).

## Consequences

- `shift()` and `push()` are O(1) at every size, on any engine, with no
  implementation-detail dependency.
- The mask is the load-bearing part. Any change that makes `_capacity` not a
  power of two silently breaks indexing rather than throwing, which is why the
  invariant is asserted in the constructor rather than left to a comment.
- Memory is not released on `shift()`. The buffer keeps its slot, and the
  reference is cleared — but the array itself stays at high-water size. For a
  queue that bursts to a million and then idles, that memory stays resident.
  This is a real trade and is not currently addressed; a `shrink()` would be the
  fix if it ever matters.

## Alternatives considered

**`Array.prototype.shift()`.** The default, and the reason this ADR exists. It is
also what `review.md`'s `PERF-006` proposes to "optimise" away — by replacing
it with `toArray()` plus an index cursor. That proposal was measured and
rejected: the `toArray()` allocates a copy of the entire queue on every tick,
**563 µs on a 200 000-entry queue**, against a `shift()` that costs **14.8 ns**.
An allocation-heavy pessimisation is worse than a documented non-issue.

**A deque from a dependency.** The library has none, and this is a structure of
about forty lines. Adding a dependency for it would be a poor trade — and the
one place a dependency _was_ worth it, `@types/node` leaking into the
declarations, is a scar the project already carries (QUAL-009).

**A linked list.** Genuinely O(1) at both ends, with per-node allocation. The
ring buffer wins on allocation and locality, and pays a full copy on each
doubling.

## Where this is visible

`guides/powerQueue.md` is the reference. `PERF-006` in `review.md` records the
measurement that rejected the obvious "optimisation", and keeps it open for the
same reason: so the next person to propose it finds the number.
