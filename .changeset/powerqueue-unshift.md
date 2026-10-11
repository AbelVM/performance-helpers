---
'performance-helpers': patch
---

### Added

`PowerQueue.unshift(item)` — enqueue at the **head**, so the item is the next one
`shift()` returns. The mirror of `push`, and the primitive a return-to-front path
needs: work that was dequeued for dispatch but could not be delivered goes back where
it came from rather than behind everything that arrived after it.

```js
const task = queue.shift();
try {
  worker.postMessage(task);
} catch {
  queue.unshift(task); // back at the front, not reordered behind later arrivals
}
```

**It is O(1), and the reason is worth stating because the instinct is the opposite.**
Inserting at the head of a ring buffer does not shift the existing items. Moving the
head back by one slot leaves every item on its same physical slot: an item at logical
index `i` sits at physical `head + i`, and its new logical index `i + 1` sits at
physical `(head - 1) + (i + 1)` — the same place. So the only work is decrementing the
head and writing one slot.

A first draft of this method looped over every item moving it back, and was wrong as
well as slow: it dropped the tail item and left a hole, because the walk overwrote
slots it had not yet read. The O(1) form is both correct and simpler, which is the usual
shape of that lesson. The wrap case — a queue whose head is not 0 — is where the wrong
arithmetic hid, and it is the case the tests lead with.

`unshift` and `shift` are exact inverses, so a dequeue-then-restore round-trip leaves
the queue exactly as it was. For bulk prepends, `unshiftMany(items)` remains the
amortised-cheap path.
