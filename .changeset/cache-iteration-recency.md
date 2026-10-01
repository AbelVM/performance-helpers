---
'performance-helpers': patch
---

**A recency mutation inside a `PowerCache` iteration loop was an infinite loop.**

```javascript
for (const [k] of cache.entries()) cache.get(k);
// never returns
```

`get()` relinks the entry to the MRU end, which is _behind_ an MRU-first cursor,
so the walk arrived back at the node it was standing on and cycled. Measured on
6 keys: 60 yields without a stop, visiting the same 6 distinct keys. `touch()`
and `set()` on a key already present reach the same state, and `touch()` is
arguably the most likely of the three to appear in a loop body, since it is
recency-only with no read and no value change. `peek()` is unaffected.

This is worse than the truncation fixed in the previous release: a truncated
walk at least returns. `for (const [k] of cache.entries()) cache.delete(k)` now
works, and `get()` in the same loop hung — the same hazard on the relink axis
that the unlink fix addressed, which is why the two are separate changes rather
than one.

The walk now visits at most as many entries as existed when it started, which
ends the cycle. Every entry is still visited in the ordinary case, because the
cycle only begins after a full pass.

**Entries past that point are not reported.** If you need every entry touched,
use a second pass:

```javascript
for (const k of Array.from(cache.keys())) cache.get(k);
```

`Array.from` is the general answer for any loop body that mutates recency.

The bound cannot truncate a walk that only deletes or only inserts: entries
added during a walk land behind the cursor, so the yield count never exceeds the
entry count — measured across all four list shapes, and over 300 clean walks the
maximum excess is 0. A `Set` of visited nodes would detect a cycle exactly but
allocates on every iteration call, which this class does not spend to save a
caller from its own loop body.
