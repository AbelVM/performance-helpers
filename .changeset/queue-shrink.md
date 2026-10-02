---
'performance-helpers': minor
---

**`PowerQueue` no longer retains its high-water mark forever.** The buffer only
ever grew — `_grow()` doubled it and nothing halved it — so a queue that took
5 000 items once kept an 8 192-slot buffer for the rest of its life. `clear()`
emptied the slots without releasing them, which is right for a container whose
purpose is bounding memory, and left no way to give the memory back.

```javascript
queue.push(...burstOfFiveThousand);
await drain(queue);
queue.capacity; // 8192
queue.shrink(); // 16
```

`shrink(minimum = 16)` reallocates the ring smaller and returns the capacity
afterwards. `minimum` is a floor for a queue expected to refill to a known size,
so steady traffic does not reallocate every cycle; it is rounded up to a power of
two, and is never below the current length, so nothing is ever dropped.

Shrinking is **explicit** on purpose. The obvious alternative — shrink inside
`shift()` whenever `size < capacity / 2` — puts a comparison and a branch on
every dequeue forever, to reclaim memory only after a burst. A caller that has
just finished a burst is the one that knows when to pay.

**This was a leak inside the library, not only a sharp edge for callers.**
`PowerSlidingWindow` keeps its timestamps in a `PowerQueue`, so a single large
`tryConsume` window left every instance holding the memory of the worst burst it
had ever seen, for the lifetime of the limiter. It now shrinks on prune: a
5 000-item burst measured **8 192 → 16** once the window aged out, and steady
traffic settles at 16 without reallocating.

Also adds **`fill(item, count)`**, which enqueues `count` copies without building
an intermediate array. Filling a window with `n` equal timestamps was
`new Array(n)`, a loop to populate the holes, then `pushMany` to walk the result
— an allocation and a second pass on every `tryConsume(n)` with `n > 1`.
`PowerSlidingWindow` uses it on that path now.

Minor rather than patch: two new public methods on a published class.

15 tests. 5 of 6 mutants caught — the sixth is **unobservable by design**, since
`fill` is a pure allocation change and reverting the call site produces an
identical queue. The equivalence itself is pinned (`fill('ts', 4)` against
`pushMany(new Array(4).fill('ts'))`); what is not pinned is which one the window
picks, and a test that could catch it would be asserting a method is _called_
rather than a property it has.
