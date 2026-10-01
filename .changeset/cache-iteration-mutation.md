---
'performance-helpers': patch
---

**Mutating a `PowerCache` while iterating it silently truncated the walk**, so the
most natural way to empty a cache removed exactly one entry and reported `size: 0`
afterwards.

```javascript
for (const [key] of cache.entries()) cache.delete(key);
// n=2 left 1, n=3 left 2, n=4 left 3, n=10 left 9
```

The walk advanced `node = node.prev` _after_ each `yield` resumed, and `_remove`
nulls both links on the node it removes — so removing the entry the iterator was
standing on set its own continuation to `null` and ended the walk. Nothing raised,
and `size` reported the truth, so a caller who did not check believed they had
cleared it. It applied to `entries()`, `entries('LRU')`, `keys()` and `values()`,
all of which share the walk.

`cleanupExpired()` called from inside a loop was the worse of the two triggers,
because it is a public maintenance method rather than a mutation the caller chose.
A bulk export that swept each turn visited the expired entry and then **no live
entries at all**, silently exporting nothing:

```javascript
for (const [key, value] of cache.entries()) {
  cache.cleanupExpired(); // the sweep unlinks the node the iterator stands on
  yield_(key, value);
}
```

This one is positional, which is why it survived: the MRU walk goes newest-first,
so a sweep only truncated when the affected node was at or before the cursor. A
cache whose expired keys were all the _oldest_ was safe, and the identical test
against that fixture passed against the broken code.

Fixed by reading the next link before each `yield` and testing whether the captured
successor is still a member of the list. That test cannot be read off the links
alone — a lone entry has both links `null` and is in the list, while a removed one
has both `null` and is not — so `_remove` moving `_head`/`_tail` past the node it
removes is what makes membership decidable.

**The contract is now documented rather than left to be discovered** (guide and
JSDoc): removing the current entry continues at the next one, removing an entry not
yet visited skips it and the walk completes, entries added during the walk are not
visited, and **two adjacent removals in one iteration step may end the walk
early**. That last one is the single residual loss and it is deliberate — closing
it means snapshotting the walk into an array, an allocation on every call to what
is a bulk-export API.

**Recency mutation inside a loop is still unsupported, and is not covered by the
above.** `get()`, `set()` on a key already present, and `touch()` relink a node to
the MRU end, which the positional walk then arrives back at, so
`for (const [k] of cache.entries()) cache.get(k)` never returns. That is a separate
defect with a separate fix (recorded as CACHE-019) and it is unchanged here — if
you need to refresh recency for everything you iterated, collect the keys with
`Array.from(cache.keys())` first.
