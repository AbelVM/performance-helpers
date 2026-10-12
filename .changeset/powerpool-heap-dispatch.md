---
'performance-helpers': patch
---

### Changed

`PowerPool`'s saturated dispatch path is O(log n) per dispatch instead of O(n),
removing an O(n²) term under sustained saturation.

The queue was a `PowerQueue` and every dispatch called `shiftHighestPriority`, which
scans every queued item to find the best one. Draining a saturated queue was therefore
quadratic in the backlog. With `priorityAgingMs` at its default of `0` the effective
priority is static, so the queue is now a `PowerPriorityQueue` — a binary heap — and
each dispatch is O(log n).

This matters more here than in a Node-only pool: a long pause on a browser main thread
is a dropped frame.

**`priorityAgingMs` above `0` keeps the O(n) scan, deliberately.** Aging makes the
effective priority `priority + (now - enqueuedAt) / priorityAgingMs`, which drifts with
the clock. A heap keys on the priority at push time, so it would order by a key that is
already stale; re-keying it costs the same O(n) the scan does. Aging is therefore the
one case that stays on the scan, and the split is documented at the site rather than
left as an apparent inconsistency.

The two paths dispatch in the **same order for the same input**, and both keep FIFO
among equal priorities — the invariant `PowerQueue.shiftHighestPriority` documents and
its tests pin. That equivalence is itself pinned by a test, so swapping the structure
is not something a future change can quietly get wrong.

### Added

- `PowerPriorityQueue.pushMany(items)` — bulk enqueue. A loop over `push`, and
  deliberately so: each push is already O(log n), so the bulk call is O(k log n) with
  no shared setup to amortise. `PowerQueue.pushMany` earns its separate implementation
  because a ring buffer can grow once and copy in blocks; a heap cannot.
- `PowerPriorityQueue.toArray()` — a snapshot in **dispatch order**: highest priority
  first, FIFO among equal priorities. Dispatch order rather than insertion order,
  because that is the useful question for a priority queue. It sorts the heap
  _entries_ rather than the items, and that is the whole subtlety: the FIFO tiebreak is
  the insertion sequence number, which lives on the entry, so sorting items directly
  would compare equal priorities as equal and fall back on the heap array's layout —
  which is a valid heap but not an insertion order. The result would look sorted and
  not be FIFO.

### Tests

5 new tests in `test/powerPool.priority.test.js` pinning that the default pool builds a
heap and an aging pool does not, that both paths dispatch the same order for the same
input, that FIFO holds through the heap, that expired deadlines are still dropped while
dispatching from the heap, and that `length` agrees on both paths.

The 12 existing tests in that file were **adapted, not deleted** — they are the pin on
FIFO-among-equal-priorities that this change's own note calls out as the invariant to
preserve. They now dispatch through a helper that uses whichever queue the pool built,
so they assert the invariant rather than the mechanism. Two assertions that expected
_insertion_ order from `toArray()` were corrected to expect _dispatch_ order, which is
the documented behaviour of the new method.

Mutation-checked 4 of 5. The survivor is reverting the dispatch to always use the scan,
which is behaviourally identical — both paths produce the same order — so it is a
performance-only mutation that only a benchmark can catch, and it is recorded as such
rather than counted as covered.
