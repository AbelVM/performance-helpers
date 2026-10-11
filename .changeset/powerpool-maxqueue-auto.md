---
'performance-helpers': patch
---

### Added

`PowerPool` accepts `maxQueueLength: 'auto'`, resolving the cap to `maxSize ** 2`.

The most common misconfiguration with this option is leaving it unbounded: nothing
refuses, nothing warns, and the failure arrives as an OOM rather than as a refusal.
`'auto'` is the affordance for that, and it is Piscina's.

```js
const pool = new PowerPool(ImageWorker, { maxSize: 8, maxQueueLength: 'auto' });
pool.getStats().maxQueueLength; // 64
```

**`Infinity` remains the default.** A cap that silently appears is a cap nobody chose,
and the whole value of a bound is that it is a decision — so this is something you opt
into rather than a default change.

The cap is resolved **once, at construction**, and a later `resize()` does not re-derive
it: a bound that moves under a running pool is a bound nobody can reason about. The
resolved number is reported by `getStats().maxQueueLength`, which previously did not
expose it at all.
