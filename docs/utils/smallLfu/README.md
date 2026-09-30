[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / utils/smallLfu

# utils/smallLfu

W-TinyLFU frequency sketch (ALG-002).

Counts how often each key is _seen_, so an admission filter can prefer keys
that recur over keys that merely arrived once. That is the whole point of
TinyLFU: an LRU admits anything that misses, so a one-off scan evicts the
working set, and a cache that scans 500 keys over a hot set of 40 keeps
**none** of them. A frequency filter rejects the one-offs and lets the hot
set survive.

Three things make it _W_-TinyLFU, and all three are here:

1. **4-bit counters**, two packed per byte. A `Uint8Array` of 8-bit counters
   would be twice the memory for no accuracy gain at these magnitudes - a
   counter saturating at 15 versus 255 changes nothing about which key is
   more frequent, and the sketch is _reset_ well before either saturates.
2. **Count-Min**, several hash rows, minimum of the row estimates. Overcount
   is the only error mode, and it is the safe one: a key may look slightly
   more popular than it is, never less.
3. **A half-life reset.** Counters would otherwise ratchet to 15 and stay
   there, freezing the filter's idea of what is hot. Instead every
   `resetAfter` increments, all counters are halved and the sample counter
   restarts - exponential decay over a sliding window, which is what the
   Caffeine/Ristretto implementations call `reset`.

## Classes

- [SmallLfuSketch](classes/SmallLfuSketch.md)

## References

### default

Renames and re-exports [SmallLfuSketch](classes/SmallLfuSketch.md)
